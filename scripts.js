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
              events: 'id++, timestamp, deck, card, alt1, alt2, result, [deck+card], [deck+card+result]'
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
		deck.cards.forEach((card) => 
		{		
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
			{
				let sumstr = '';
				for (var side of card.sides)
					sumstr += side + ', ';
					
				card.id = sumstr.hash()		
			}
		});
		
		if (!( 'id' in deck))
			deck.id = (deck.name + '').hash()		
		
		lt.decks[deck.name] = deck
		
		console.log(deck.name + ' loaded');
		
		await lt.computeScores(deck);
		
		console.log(deck.name + ' scores computed');
	},

	computeScores : async function(deck)
	{
		for (let card of deck.cards) 
		{
		
			let cardId = card.id;
			let deckId = deck.id;

			await lt.db.events // latest correct
				.where('[deck+card+result]').equals([deckId,cardId,0]).sortBy('timestamp')
				.then(function(events){
					if (events.length > 0)
					{
						card.timeSinceCorrect = Date.now() - events[0].timestamp
						
						if (card.timeSinceSeen == null || card.timeSinceSeen > card.timeSinceCorrect)
							card.timeSinceSeen = card.timeSinceCorrect
					} 
				});
								
			await lt.db.events // latest incorrect
				.where('[deck+card+result]').anyOf([deckId,cardId, 1], [deckId,cardId, 2]).sortBy('timestamp')
				.then(function(events){
					if (events.length > 0)
					{
						card.timeSinceIncorrect = Date.now() - events[0].timestamp
						
						if (card.timeSinceSeen == null || card.timeSinceSeen > card.timeSinceIncorrect)
							card.timeSinceSeen = card.timeSinceIncorrect
					}
				});
								
// 			await lt.db.events // latest correct
// 				.where('[deck+card]').equals([deckId,cardId]).sortBy('timestamp')
// 				.then(function(events){
// 				
// 					inc = 0; tot = events.length;
// 					events.foreach((ev) => 
// 					{
// 						inc += 1
// 					
// 						
// 					});
// 
// 				});


			card.score = [card.timeSinceSeen, card.timeSinceCorrect, card.timeSinceIncorrect];

		}		

	},
	
	// * sub-namespace for the current session
	session : {
	
		startSession : async function(deck)
		{

			lt.session.deck = deck
			await lt.computeScores(deck)
			
			lt.session.generate();
		},
	
		generate : function() 
		{
			let deck = lt.session.deck
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			let sample = _.sampleSize(deck.cards, 3);
			let corr = _.sample([0, 1, 2]);

			let q = sample[corr].sides[0];

			$("article").html(
				lt.templates.mc.render({
					question: q,
					answer0: sample[0].sides[1],
					answer1: sample[1].sides[1],
					answer2: sample[2].sides[1]
				})
			)
			
			if (q.length < 4)
				$(".frame .question").addClass("short")
			else if (q.length < 10)
				$(".frame .question").addClass("medium")
			
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
			      deck: deck.id,
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
 				  result: corr
				},
				lt.session.processAnswer
			)            
		},
	
		processAnswer : function(e)
		{
			let answered = $(e.target).data('answer')
			let correct = e.data.result

			console.log(e.data)
			lt.db.events.add(e.data)

			if(answered == correct)
			{
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.session.failed
				lt.sounds.incorrect.play()
			}
		},
	}
}

$(function() 
{
// 
// 	// - init environment
// 	let defer = lt.init();
			
	// * Load page	
	lt.init().then(function() {
	
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
					console.log(Object.keys(card), card.score);
					
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