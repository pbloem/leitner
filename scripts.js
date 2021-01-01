'use strict';

String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	init : function() 
	{

		lt.db = new Dexie('leitner')
		
		lt.db.version(1).stores({
              events: 'id++, timestamp, deck, card, alt1, alt2, result, [deck+card], [deck+card+result]'
        });
		
		
	},
	
	deck_files : [
		'../decks/hanzi01.json',
		'../decks/capitals.json',
	],
	
	templates : { mc: $.templates("#mc") },
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : function(deck) 
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
		
		console.log(deck.name + ' loaded')
	},

	computeScores : async function(deck)
	{
		await deck.cards.forEach(async(card) => 
		{
			let cardId = card.id
			let deckId = deck.id

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
		});		

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

	// - init database
	lt.init();

	// - load decks
	var rqs = Array();
	lt.deck_files.forEach(function(df)
	{
		rqs.push($.getJSON(df, lt.loadDeck));
	});
	
	var defer = $.when.apply($, rqs);
	defer.done(function() {
		let params = new URLSearchParams(window.location.search);
		
		if (params.has('deck'))
		{
			lt.session.startSession(lt.decks[params.get('deck')]);
		} else
		{
			$("article").append('<p>No deck specified.</p>')
		}	
	});


});