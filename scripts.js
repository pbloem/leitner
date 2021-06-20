'use strict';

String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	/**
	 * Initialize the Leitner environment by initializing the database, and loading all 
	 * card decks. 
	 *
	 * Returns a defer promise (?) that concluded when the environment is properly loaded.
	 */
	init : async function() 
	{

		// - init database
		lt.db = new Dexie('leitner')
		
		lt.db.version(1).stores({
              events: 'id++, timestamp, deck, card, alt1, alt2, correct, [deck+card], [deck+card+correct]'
        });
		
		// - load all decks
		let rqs = Array();
		for (let df of lt.deck_files)
		{
			let prm = $.getJSON(df).then(lt.loadDeck)
			rqs.push(prm);
		}
		
		await Promise.all(rqs)
	},
	
	// Add new decks here
	deck_files : [
		'../decks/hanzi01.json',
		'../decks/capitals.json',
	],
	
	// TODO: automate this in init(). Use a query to collect all script elements with type="text/x-jsrender"
	templates : { 
		mc: $.templates("#mc"), 
		text: $.templates("#text"), 
		decklink: $.templates("#decklink") 
	},
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : async function(deck) 
	{
	
		if (!( 'id' in deck))
			deck.id = (deck.name + '').hash()	
			
		deck.cards.forEach((card) => 
		{		
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
			{
				let sumstr = deck.id  + ': ';
				for (var side of card.sides)
					sumstr += side + ', ';
					
				card.id = sumstr.hash()		
			}
		});
		
		lt.decks[deck.name] = deck
		
		console.log(deck.name + ' loaded.');
		
		await lt.computeScores(deck);
		
		console.log(deck.name + ' scores computed.');
		
		// Default order is by ID
		deck.cards = _.sortBy(deck.cards, [function(card){return card.id; }])
		
		// TODO: 
		//  validate that nr. of sides for each card is the same as deck.sides.length
		//  set default if key 'typing-sides' is missing.
		//  check max(typableSides)
	},
	
	mask : function(text, prop) 
	{
		let num = Math.floor(text.length * prop)
		let idxs = new Set(_.sampleSize(_.range(text.length), num)) // indices to be masked out
		
		let res = ''
		for (let i of _.range(text.length))
		{
			if (idxs.has(i) && text.charAt(i) !== ' ')
				res += '*';
			else
				res += text.charAt(i);
		}
		
		return res
	},

	
	/**
	 * Computes Levenshtein distance. From https://gist.github.com/andrei-m/982927
	 *
	 * For this function:
     *	 Copyright (c) 2011 Andrei Mackenzie
	 *	 Permission is hereby granted, free of charge, to any person obtaining a copy of 
	 *   this software and associated documentation files (the "Software"), to deal in the 
	 *   Software without restriction, including without limitation the rights to use, 
	 *   copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
	 *   Software, and to permit persons to whom the Software is furnished to do so, subject
	 *   to the following conditions: The above copyright notice and this permission 
	 *   notice shall be included in all copies or substantial portions of the Software.
	 *	 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
	 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
	 *   FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR 
	 *   COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN 
	 *   AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION 
	 *   WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
	 */
	levDistance : function(a, b)
	{
	
		  if(a.length == 0) return b.length; 
		  if(b.length == 0) return a.length; 

		  var matrix = [];

		  // increment along the first column of each row
		  var i;
		  for(i = 0; i <= b.length; i++)
		  {
			matrix[i] = [i];
		  }

		  // increment each column in the first row
		  var j;
		  for(j = 0; j <= a.length; j++)
		  {
			matrix[0][j] = j;
		  }

		  // Fill in the rest of the matrix
		  for(i = 1; i <= b.length; i++)
		  {
			for(j = 1; j <= a.length; j++)
			{
			  if(b.charAt(i-1) == a.charAt(j-1))
			  {
				matrix[i][j] = matrix[i-1][j-1];
			  } else 
			  {
				matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, // substitution
									Math.min(matrix[i][j-1] + 1, // insertion
										matrix[i-1][j] + 1)); // deletion
			  }
			}
		  }

		  return matrix[b.length][a.length];
	},
	
	
	/**
	 * Scoring based on an approximation of the Leitner system. 
	 *
	 * We look at the most recent sequence of fails and successes. Let k be the length of 
	 * contiguous successes since the most recent failure. k determines the "pile" the card
	 * is in. Cards in pile k are shown with probability 1 - ~2^-k
	 * 
	 * We then modify this score with a multiplier, based on the number of days that have 
	 * passed since the card was last seen. We assume, for now that the probability of 
	 * remembering a card decays uniformly by .95 per day. 
	 *
	 */
	computeScores : async function(deck)
	{
		let msPerDay = 8.64e+7;
		let decayRate = 0.95
	
		for (let card of deck.cards) 
		{
			
			await lt.db.events // latest seen
 				.where('[deck+card]').equals([deck.id,card.id]).reverse().sortBy('timestamp')
 				.then(function(events)
 				{
 					// Compute length of most recent contiguous sequence of successes
 					let k = 0
 					for (event of events)
 						if (event.correct)
 							k ++;
 						else
 							break;
 					
 					let baseScore = 1.0 - Math.pow(2.0, -k)
 					
 					// Compute time since seen modifier
 					let msSinceSeen = events.length > 0 ? Date.now() - events[0].timestamp : Number.MAX_SAFE_INTEGER;
 					let daysSinceSeen = msSinceSeen / msPerDay;
 					
 					let decay = Math.pow(0.95, daysSinceSeen)
 					
 					card.score = baseScore * decay
//  				console.log(card.sides[0], k, baseScore, daysSinceSeen, decay, card.score)
 				});
 		}
	
	},
	
	sigmoid : function(x) 
	{
		return 1.0 / (1 + Math.exp(-x))
	},

	// Parameters of first predictor
	mean : - 538986862113.73,
	std : 7638229405800. / 1e1,

	/**
	 * Logit scoring based on simple features. Doesn't work very well.
	 */
	computeScoresLogit : async function(deck)
	{
	
		for (let card of deck.cards) 
		{
			
			await lt.db.events // latest seen
 				.where('[deck+card]').equals([deck.id,card.id]).reverse().sortBy('timestamp')
 				.then(function(events)
 				{
 					if (events.length > 0)
						card.timeSinceSeen = Date.now() - events[0].timestamp;
 				});

			await lt.db.events // latest correct
				.where('[deck+card+correct]').equals([deck.id,card.id,1]).reverse()
 				.sortBy('timestamp').then(function(events) 
				{				
					if (events.length > 0)
						card.timeSinceCorrect = Date.now() - events[0].timestamp;
				});
								
			await lt.db.events // latest incorrect (this currently works only for MC)
				.where('[deck+card+correct]').equals([deck.id,card.id,0]).reverse().sortBy('timestamp')
				.then(function(events)
				{
					if (events.length > 0)
						card.timeSinceIncorrect = Date.now() - events[0].timestamp;
				});

			if (card.timeSinceSeen === undefined)
				card.timeSinceSeen = Date.now()

			// Compute score logit
			// -- This is an unbounded value. The more negative it is, the more likely the 
			//    user will get the card wrong.
			card.score_logit = (- card.timeSinceSeen - lt.mean)/ lt.std

			card.score = lt.sigmoid(card.score_logit)		
		}		
	},
	
	/** 
	 * Sub-namespace for the current session
	 *
	 */
	session : {
	
		startSession : async function(deck)
		{

			lt.session.deck = deck
						
			lt.session.generate();
			
			lt.session.recent = []
		},
		
		/**
		 * Buffer of recently seen cards (to be rejected from sampling)
		 */
		recent : [], 
		recentMax : 5,
		
		/**
		 * Sample a card from the deck according to the scores, using the pivot strategy. 
		 *
		 * The strategy is to sample cards whose probability of being answered correctly 
		 * is close to 0.5. Doing this repeatedly eventually pushes all probabilities up 
		 * to 1.0
		 *
		 * NB: Re-orders the cards
		 */
		samplePivot : function()
		{
			let deck = lt.session.deck
		
			// Sort by score
			_.sortBy(deck.cards, [function(card){return card.score; }])
			
			// Find the card whose probability is closest to 0.5
			let pivot;
			let smallestDistance = Number.POSITIVE_INFINITY;
			
			deck.cards.forEach((card, i) =>
			{
				let distance = Math.abs(card.score - 0.5);				
				if (distance < smallestDistance)
				{
					pivot = i;
					smallestDistance = distance;
				}
			});
			
			
			// Sample around that card
			let target = pivot + _.sample([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
			target = _.clamp(target, 0, deck.cards.length);
						
						
			console.log('pivot score', deck.cards[target].score)
			console.log('pivot time since seen', humanizeDuration(deck.cards[target].timeSinceSeen), deck.cards[target].timeSinceSeen)
						
			return deck.cards[target]
		},
		
		
	 	/**
		 * Sample a card from the deck according to the scores, using the sequential strategy.
		 *
		 * The strategy is to keep the cards sorted, and to move from left to right. Then 
		 * at point, we sample that particular card with the probability that it will be 
		 * answered incorrectly.
		 * 
		 * TODO: Add a recovery time, whereby cards cannot be chosen if they have been 
		 * among the  last three cards shown.
		 *
		 *
		 * NB: Assumes that the cards maintain a fixed order.
		 */
		sampleSeq : function()
		{
			let res = null;
			let deck = lt.session.deck;

			for (let trial of _.range(100)) // allow 100 rejections
			{
				for (let card of deck.cards)
				{
					let r = _.random(0,1,true);
					if (r > card.score)
					{
						res = card;	
						break;
					}
				}
				
				if (lt.session.recent.indexOf(res.id) == -1)
					break;
// 				else
// 					console.log('Rejected sample: ', res.id);
			}
				
			
			if (res == null) // Clever approach failed. Sample uniformly.
			{
				console.log('Could not sample by scores. Sampling uniformly.')
				res = _.sample(deck.cards);
			}
			
			lt.session.recent.push(res.id)
			while(lt.session.recent.length > lt.session.recentMax) 
				lt.session.recent.shift()
			//--  dequeue until buffer is at max size
			
			
			return res
			
		},
	
		mcProb : 0.5,
	
		generate : function() 
		{
			if (_.random(0, 1, true) < lt.session.mcProb || lt.session.deck.typableSides.length == 0) 
				lt.session.generateMC();
			else
				lt.session.generateText();
		
		},
		
		/**
		 * Generate a text field question. One of the sides of the card is shown, and the 
		 * user is asked to type in the content of one of the other sides.
		 *
		 */
		generateText : function()
		{
			let deck = lt.session.deck

			let back  = _.sample(deck.typableSides);
			let front = _.sample(
				_.without(
					_.range(deck.sides.length),
					back
				)
			);
			
			console.log('front', front, 'back', back, deck.sides)

			$("article").empty();

			let card = lt.session.sampleSeq(); // draw a card
			
			let question = card.sides[front];
			let answer   = card.sides[back];

			$("article").html(
				lt.templates.text.render({
					frontname: deck.sides[front],
					backname: deck.sides[back],
					question: question,
				})
			);
			
			$(".frame #answer").focus()
			
			lt.session.createProgress(deck.cards.indexOf(card));
			
			if (question.length < 4)
				$('.frame .question').addClass('short')
			else if (question.length < 10)
				$('.frame .question').addClass('medium')
				
			$('.frame .question').addClass('side-'+front);
			$('.frame form').addClass('side-'+back); 
			
			$("article form").on(
				'submit',
				{ 
					timestamp: Date.now(),
					deck: deck.id,
					card: card.id,
					question: question,
					front: front,
					back: back,			  
					allSides: card.sides,    
					correctAnswer: answer,
				},
				lt.session.processTextAnswer
			)
		},		
		
		/**
		 * Allowed edit distance between answer and truth, as a proportion of the length 
		 * of the answer
		 */
		distAllowed: 0.2,
		
		/**
		 * Check if a given answer is close enough to the correct answer to count as correct
		 * 
		 */
		checkText : function(correct, answered)
		{
			// - Trim, normalize accents, cases and diacritics
			correct = correct.toLowerCase().trim();
			answered = answered.toLowerCase().trim();
			
			correct = correct.normalize("NFD").replace(/\p{Diacritic}/gu, "");
			answered = answered.normalize("NFD").replace(/\p{Diacritic}/gu, "");
			
			let distance = lt.levDistance(correct, answered);
		
			return distance < lt.session.distAllowed * correct.length;
		},
				
		processTextAnswer : function(e)
		{			    
			let edata = e.data; // -- this is apparently required to stop some race conditions from JS re-using its event objects

			e.preventDefault(); // Stop the default form submit action.
				    		    
			let etarget = e.target;
		
			let answered = $('article .frame #answer').val()
			let correct = edata.correctAnswer
			
			let success = lt.session.checkText(correct, answered)
			
			console.log(answered, correct, edata)
			
			// -- Check whether user typed wrong side
			let wrongSide = false, sideAnswered = -1;
			if (! success) 
			{
				edata.allSides.forEach((side, i) => {
					if (i != edata.front && i != edata.back)
						if(lt.session.checkText(side, answered))
						{
							wrongSide = true;
							sideAnswered = i;
						}
				});			
			}

			if (! wrongSide) 
			{
				let newRow = 
				{
					timestamp: edata.timestamp,
					deck: edata.deck,
					card: edata.card,
					answered: answered,
					front: edata.front,
					back: edata.back,
					correct: success ? 1 : 0,
					questionType: 'text',
				}
			
				lt.db.events.add(newRow).then (result =>
				{
					console.log(newRow);
				}).catch('ConstraintError', er => 
				{
					console.error ("Constraint error: " + er.message);
					console.error(newrow);
				});

				lt.computeScores(lt.session.deck)
			}

			if(success)
			{
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.sounds.incorrect.play()

			
				if (wrongSide) // typed wrong side
				{
					setTimeout(function(){$('article .frame #answer').val('');}, 500);

					let hint = $('article .frame #hint');
				
					hint.empty();
					hint.removeClass('hidden');
					hint.addClass('visible');

					console.log(0);
					hint.append('Wrong side. Type the '+lt.session.deck.sides[edata.back]+' answer.');
					setTimeout(function(){hint.toggleClass('visible hidden');}, 1500);
					
				} else {
			

					setTimeout(function(){$('article .frame #answer').val('');}, 500);

					let hint = $('article .frame #hint');
				
					let wrongs = parseInt(hint.attr('data-wrong'))
					console.log(wrongs, ' incorrect answers.')
					hint.attr('data-wrong', wrongs + 1)
				
					hint.empty();
					hint.removeClass('hidden');
					hint.addClass('visible');

					if (wrongs == 0)		
					{	
						console.log(0);
						hint.append(lt.mask(correct, 0.95));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
				
					} else if (wrongs == 1)
					{	
						console.log(1);
						hint.append(lt.mask(correct, 0.5));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
					} else if (wrongs == 2)
					{
						console.log(2);
						hint.append(lt.mask(correct, 0.25));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
					} else 
					{	
						hint.append(correct);
					}
				}
			}
			
		},
		
		/**
		 * Generate a multiple-choice question. One of the sides of the card is shown, and 
		 * the user is asked to choose the correct value of another side out of three 
		 * options.
		 *
		 */
		generateMC : function()
		{
			let deck = lt.session.deck
			
			
			let back  = _.sample(_.range(deck.sides.length));
			let front = _.sample(
				_.without(
					_.range(deck.sides.length),
					back
				)
			);
			
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			let sampleTarget = lt.session.sampleSeq()
			
			console.log(sampleTarget.sides[0], 'score', sampleTarget.score);
			console.log('time since seen', humanizeDuration(sampleTarget.timeSinceSeen));
			
			
			let sampleAlt = _.sampleSize(_.without(deck.cards, sampleTarget), 2)
			let sample = [sampleTarget].concat(sampleAlt)
						
			let ord = _.shuffle([0, 1, 2]); // random order of the answers
			let correct = ord[0]
			
			let answers = [undefined, undefined, undefined]
			answers[ord[0]] = sample[0]
			answers[ord[1]] = sample[1]			
			answers[ord[2]] = sample[2]

			let q = sampleTarget.sides[front];

			$("article").html(
				lt.templates.mc.render({
					frontname: deck.sides[front],
					backname: deck.sides[back],
					question: q,
					answer0: answers[0].sides[back],
					answer1: answers[1].sides[back],
					answer2: answers[2].sides[back],
				})
			);
			
			lt.session.createProgress(deck.cards.indexOf(sampleTarget));
			
			if (q.length < 4)
				$(".frame .question").addClass("short")
			else if (q.length < 10)
				$(".frame .question").addClass("medium")
				
			$('.frame .question').addClass('side-'+front);
			$('.frame form').addClass('side-'+back); 
									
			// Add answer evenbt handler
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
			      deck: deck.id,
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
				  correctAnswer: correct,
				  front: front,
				  back: back, 
				},
				lt.session.processMCAnswer
			)
			
			// Add keyboard shortcuts
			$(document).on('keydown', function(event) {
				if (event.key == 1)
				{
					$("article .frame button#a0").trigger('click')
					event.preventDefault();
				} else if (event.key == 2)
				{
					$("article .frame button#a1").trigger('click')					
					event.preventDefault();
				} else if (event.key == 3)
				{
					$("article .frame button#a2").trigger('click')					
					event.preventDefault();
				}
			});
            
		},
	
		processMCAnswer : function(e)
		{				
		    e.preventDefault(); // Stop the default form submit action.

			let edata = e.data // -- this is apparently required to stop some race conditions from JS re-using its event objects
			let etarget = e.target
		
			let answered = $(etarget).data('answer')
			let correct = edata.correctAnswer

			let newRow = 
			{
				timestamp: edata.timestamp,
				deck: edata.deck,
				card: edata.card,
				alt1: edata.alt1,
				alt2: edata.alt2,
				front: edata.front,
				back: edata.back,
 				questionType: 'mc',
 				correct: edata.correctAnswer == answered ? 1 : 0
			}
			
			lt.db.events.add(newRow).then (result =>
			{
			    console.log(newRow);
			}).catch('ConstraintError', er => 
			{
			    console.error ("Constraint error: " + er.message);
			    console.error(newrow);
			});

			lt.computeScores(lt.session.deck)
// 			.then(function() {		
// 				lt.session.updateProgress();
// 			});

			// --- todo: recompute only for current card


			if(answered == correct)
			{
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
				$(document).off('keydown')
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.sounds.incorrect.play()
			}
		},
		
		createProgress : function(targetIdx)
		{
			let scores = lt.session.deck.cards.map((card) => card.score);
			let pix = 4
			
			const parent = d3.select('div.progress')
			const svg = parent.append('svg')
			
			svg.attr('width', pix * scores.length)
			   .attr('height', 2*pix)
// 			   .attr("style", "outline: thin solid red;")
			    
			let xCoord = function(i) {return i == targetIdx ? i * pix - (pix/2) : i * pix};
			let yCoord = function(i) {return i == targetIdx ? 0 : pix/2};
			
			const prog = svg.selectAll("g")
				.data(scores)
				.join("g")
					.attr("transform", (d, i) => `translate(${xCoord(i)}, ${yCoord(i)})`);
					
					
					
			var colorScale = d3.scaleSequential(d3.interpolateRdYlGn)
    			.domain([0.0, 1.0])
    								
			prog.append("rect")
				.attr("fill", "steelblue")
				.attr("width", (score, i) => {return i == targetIdx ? 2*pix : pix})
				.attr("height", (score, i) => {return i == targetIdx ? 2*pix : pix})
				.attr('fill', (score, i) => {return colorScale(score);})

				
			// todo: would be nicer to update this rather than redraw every time									
				
		}, 
		

	},

	/**
	 * Utility functions.
	 */	
	util : {	
	
	},

}

$(function() 
{
// 
// 	// - init environment
// 	let defer = lt.init();
			
	// * Load page	
	lt.init().then(function() 
	{
	
		let params = new URLSearchParams(window.location.search);
		
		if (params.has('deck'))
		{
			if (params.has('list'))
			{
				// List all cards in the deck together with any information

				let deck = lt.decks[params.get('deck')]
				
				$("article").append($('<h1>').append(deck.name))

				$("article").append($('<ul>', {id: 'cards', class: 'cards'}));
				
				deck.cards.forEach((card, idx) =>
				{ 							
					let li = $('<li>', {class: 'card'});
					li.append($('<h3>').append('card ' + idx + ':'))
					
					let ulSides = $('<ul>', {class: 'sides'});					
					card.sides.forEach((side, j) =>
					{
						ulSides.append($('<li>', {class: 'side'}).append(j+':'+side));
					});
										
					li.append(ulSides);
					li.append($('<span>', {class:'score'}).append('score: ' + card.score));
					
					$('ul#cards').append(li);
				});
				
			} else 
			{
				lt.session.startSession(lt.decks[params.get('deck')]);
			}
		} else
		{
			// - Print the list of decks
			$("article").append('<p>No deck specified. Available decks:</p>')
			
			$("article").html($('<ul>', {id: 'decks', class: 'decks'}));
			
			console.log(lt.templates)
			
			for (let [name, deck] of Object.entries(lt.decks)) 
			{ 
				$('ul#decks').append(
					lt.templates.decklink.render({
						href: '/?deck=' + name,
						href_list: '/?deck=' + name + '&list=true',
						text: name
				}));
			}
						
			
		}	
	});


});